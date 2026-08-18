import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { Badge, Empty, PageHeader, Stat, relativeTime } from "@/components/ui";
import {
  funnel,
  kindPerformance,
  providerPerformance,
  recentRuns,
  type KindPerformance,
  type ProviderPerformance,
  type RunRecord,
} from "@/lib/analytics";
import { SIGNAL_LABEL, type SignalKind } from "@/lib/signals/types";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const [totals, kinds, providers, runs] = await Promise.all([
    funnel(),
    kindPerformance(),
    providerPerformance(),
    recentRuns(10),
  ]);

  if (totals.signals === 0) {
    return (
      <>
        <PageHeader title="Activity" sub="What the pipeline produced, and what came back." />
        <Empty title="Nothing to report yet">
          Run the pipeline from the{" "}
          <Link href="/" className="press underline">
            Signals
          </Link>{" "}
          tab. This tab fills in once signals have been scored and you have recorded what
          happened to the leads.
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Activity" sub="What the pipeline produced, and what came back." />

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Signals" value={totals.signals} />
        <Stat label="Qualified" value={totals.qualified} />
        <Stat label="Sequenced" value={totals.sequenced} />
      </div>

      <section className="card mt-4 p-4">
        <h2 className="text-sm font-semibold">Funnel</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Each stage is a filter, so the drop between rows is the point rather than a loss.
          The last three rows come from outcomes you record on the Leads tab — Juniper never
          sends anything, so it cannot observe them itself.
        </p>
        <div className="mt-3 space-y-2">
          <FunnelRow label="Signals detected" value={totals.signals} of={totals.signals} />
          <FunnelRow label="Scored" value={totals.scored} of={totals.signals} />
          <FunnelRow label="Passed ICP filter" value={totals.qualified} of={totals.signals} />
          <FunnelRow label="Address found" value={totals.withEmail} of={totals.signals} />
          <FunnelRow label="Sequence written" value={totals.sequenced} of={totals.signals} />
          <FunnelRow label="Contacted" value={totals.contacted} of={totals.signals} />
          <FunnelRow label="Replied" value={totals.replied} of={totals.signals} />
          <FunnelRow label="Meeting booked" value={totals.meetings} of={totals.signals} />
        </div>
      </section>

      <section className="card mt-4 p-4">
        <h2 className="text-sm font-semibold">Trigger performance</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Reply rate per trigger type, against the intent weight the taxonomy assumes. Where a
          heavily weighted trigger keeps failing to produce replies for your ICP, the weight is
          the thing that is wrong — narrow the next run to the triggers that work.
        </p>

        {totals.contacted === 0 && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-wash p-3 text-[11px] leading-relaxed">
            <CircleAlert size={13} className="mt-px shrink-0" />
            No outcomes recorded yet, so reply rates are blank. Mark leads as contacted or
            replied on the Leads tab to start measuring.
          </p>
        )}

        <div className="-mx-4 mt-3 overflow-x-auto px-4">
          <table className="w-full min-w-[430px] text-left text-xs">
            <thead className="text-[11px] text-muted">
              <tr className="border-b border-line">
                <th className="py-2 font-medium">Trigger</th>
                <th className="py-2 text-right font-medium">Weight</th>
                <th className="py-2 text-right font-medium">Leads</th>
                <th className="py-2 text-right font-medium">Avg fit</th>
                <th className="py-2 text-right font-medium">Contacted</th>
                <th className="py-2 text-right font-medium">Reply rate</th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => (
                <KindRow key={k.kind} row={k} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card mt-4 p-4">
        <h2 className="text-sm font-semibold">Source quality</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Share of each source&apos;s scored signals that survived ICP filtering. A source
          producing volume and no qualified leads is spending scoring calls for nothing —
          tighten its watch terms rather than raising its limit.
        </p>
        <ul className="mt-3 divide-y divide-line">
          {providers.map((p) => (
            <ProviderRow key={p.provider} row={p} />
          ))}
        </ul>
      </section>

      <section className="card mt-4 p-4">
        <h2 className="text-sm font-semibold">Recent runs</h2>
        <ul className="mt-2 divide-y divide-line">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      </section>
    </>
  );
}

function FunnelRow({ label, value, of }: { label: string; value: number; of: number }) {
  const share = of > 0 ? value / of : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span>{label}</span>
        <span className="tabular-nums text-muted">
          <span className="font-medium text-ink">{value}</span>
          {of > 0 && ` · ${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%`}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-wash">
        <div className="h-full rounded-full bg-ink" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

function KindRow({ row }: { row: KindPerformance }) {
  return (
    <tr className="border-b border-line last:border-0">
      <td className="py-2 pr-2">{SIGNAL_LABEL[row.kind as SignalKind] ?? row.kind}</td>
      <td className="py-2 text-right tabular-nums text-muted">{row.assumedIntent}</td>
      <td className="py-2 text-right tabular-nums">{row.leads}</td>
      <td className="py-2 text-right tabular-nums text-muted">{row.avgFit}</td>
      <td className="py-2 text-right tabular-nums text-muted">{row.contacted}</td>
      <td className="py-2 text-right font-medium tabular-nums">
        {row.replyRate === null ? "—" : `${Math.round(row.replyRate * 100)}%`}
      </td>
    </tr>
  );
}

function ProviderRow({ row }: { row: ProviderPerformance }) {
  return (
    <li className="flex items-center gap-3 py-2.5 text-xs">
      <span className="font-medium">{row.provider}</span>
      <span className="text-muted">
        {row.signals} signal{row.signals === 1 ? "" : "s"} · {row.qualified} qualified
      </span>
      <span className="ml-auto tabular-nums">
        {row.precision === null ? "—" : `${Math.round(row.precision * 100)}%`}
      </span>
    </li>
  );
}

function RunRow({ run }: { run: RunRecord }) {
  const s = run.stats;
  return (
    <li className="py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">{relativeTime(run.startedAt)}</span>
        {run.ok ? (
          <Badge tone="quiet">ok</Badge>
        ) : run.finishedAt ? (
          <Badge tone="neutral">failed</Badge>
        ) : (
          // Neither finished nor errored: the function was killed mid-run.
          <Badge tone="neutral">interrupted</Badge>
        )}
        {s.truncated && <Badge tone="quiet">stopped early</Badge>}
      </div>
      <p className="mt-1 text-[11px] text-muted">
        {s.signalsFound ?? 0} seen · {s.signalsNew ?? 0} new · {s.qualified ?? 0} qualified ·{" "}
        {s.sequencesWritten ?? 0} sequenced
        {s.durationMs ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : ""}
      </p>
      {run.error && <p className="mt-1 text-[11px] text-muted">{run.error}</p>}
    </li>
  );
}
