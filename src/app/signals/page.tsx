import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { RunPanel } from "@/components/run-panel";
import { Badge, Empty, FreshnessTag, PageHeader, relativeTime } from "@/components/ui";
import { getProfile } from "@/lib/db";
import { listSignalFeed, type SignalFeedRow } from "@/lib/pipeline";
import { collectableKinds } from "@/lib/signals/registry";
import { SIGNAL_LABEL, type SignalKind } from "@/lib/signals/types";

export const dynamic = "force-dynamic";

/**
 * Everything the sources returned, including what scoring threw away.
 *
 * This is the diagnostic view: it answers "why is that not a lead?" and "is
 * this source producing anything?". The full run controls live here rather than
 * on the Leads page because this is where you can see what turning them did.
 */
export default async function SignalsPage() {
  const [profile, feed] = await Promise.all([getProfile(), listSignalFeed(60)]);

  const kept = feed.filter((r) => !r.disqualified);
  const dropped = feed.length - kept.length;

  return (
    <>
      <PageHeader
        title="Signals"
        sub={
          feed.length === 0
            ? "Every event the sources return lands here, scored or not."
            : `${feed.length} events from your sources. ${
                dropped > 0
                  ? `${dropped} scored outside your ICP and never became leads.`
                  : "All of them cleared ICP scoring."
              }`
        }
      />

      <RunPanel ready={Boolean(profile)} kinds={collectableKinds()} />

      <div className="mt-6 space-y-2">
        {feed.length === 0 ? (
          <Empty title="No signals yet">
            {profile ? (
              <>
                Run the pipeline above, or add job boards to watch on the{" "}
                <Link href="/setup" className="press underline">
                  Setup
                </Link>{" "}
                tab for real hiring signals.
              </>
            ) : (
              <>
                Add your website on the{" "}
                <Link href="/" className="press underline">
                  home page
                </Link>{" "}
                first — scoring needs an ICP to judge against.
              </>
            )}
          </Empty>
        ) : (
          feed.map((row) => <SignalRow key={row.id} row={row} />)
        )}
      </div>
    </>
  );
}

function SignalRow({ row }: { row: SignalFeedRow }) {
  const kind = row.kind as SignalKind;

  return (
    <article className={`card p-4 ${row.disqualified ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="solid">{SIGNAL_LABEL[kind] ?? kind}</Badge>
            <Badge tone="quiet">{row.provider}</Badge>
            <FreshnessTag value={row.freshness} />
            {row.disqualified && <Badge tone="quiet">out of ICP</Badge>}
          </div>
          <h2 className="mt-2 text-sm font-medium leading-snug">{row.headline}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">{row.evidence}</p>
        </div>

        {row.totalScore !== null && (
          <div className="shrink-0 text-right">
            <div className="text-xl font-semibold tabular-nums leading-none">{row.totalScore}</div>
            <div className="text-[10px] text-muted">score</div>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3 text-[11px] text-muted">
        <span>{row.company}</span>
        {/* The event's own date where the source gave one — when it happened is
            what decides whether it is still worth acting on, not when we saw it. */}
        <span>{relativeTime(row.occurredAt ?? row.detectedAt)}</span>
        {row.url && (
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer noopener"
            className="press ml-auto inline-flex items-center gap-1 underline"
          >
            Source <ExternalLink size={11} />
          </a>
        )}
      </div>
    </article>
  );
}
