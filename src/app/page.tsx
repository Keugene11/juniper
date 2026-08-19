import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { ProfileForm } from "@/components/profile-form";
import { RunPanel } from "@/components/run-panel";
import { Badge, Empty, FreshnessTag, PageHeader, relativeTime } from "@/components/ui";
import { getProfile } from "@/lib/db";
import { listSignalFeed, type SignalFeedRow } from "@/lib/pipeline";
import { collectableKinds } from "@/lib/signals/registry";
import { SIGNAL_LABEL, type SignalKind } from "@/lib/signals/types";

export const dynamic = "force-dynamic";

export default async function SignalsPage() {
  const profile = await getProfile();

  // Nothing downstream works without an ICP: the run panel cannot run, the feed
  // has nothing in it, and every control on the page is inert. Showing that
  // machinery first and relegating the one action that matters to a line of
  // muted text pointing at another tab gets the order exactly backwards.
  if (!profile) return <Onboarding />;

  const feed = await listSignalFeed(60);

  return (
    <>
      <PageHeader
        title="Signals"
        sub={`Watching for buying events that match ${profile.companyName}'s ICP.`}
      />

      <RunPanel ready kinds={collectableKinds()} />

      <div className="mt-6 space-y-2">
        {feed.length === 0 ? (
          <Empty title="No signals yet">
            Run the pipeline to pull from your configured sources. Add job boards to watch on the{" "}
            <Link href="/setup" className="press underline">
              Setup
            </Link>{" "}
            tab for real hiring signals.
          </Empty>
        ) : (
          feed.map((row) => <SignalRow key={row.id} row={row} />)
        )}
      </div>
    </>
  );
}

/**
 * First run. One question, one button — everything else on this page would be
 * a control for a machine that cannot start yet.
 */
function Onboarding() {
  return (
    <>
      <PageHeader
        title="Start here"
        sub="Juniper watches for public events that mean a company is in-market right now, then writes outreach about that specific event. First it needs to know what you sell."
      />

      <ProfileForm initial={null} />

      <section className="card mt-4 p-4">
        <h2 className="text-sm font-semibold">What happens after that</h2>
        <ol className="mt-3 space-y-3">
          <Step n={1} title="Choose who to watch">
            Add companies on the{" "}
            <Link href="/setup" className="press underline">
              Setup
            </Link>{" "}
            tab and Juniper monitors their job boards. Keyword sources need no watchlist — they
            run off the terms read from your site.
          </Step>
          <Step n={2} title="Run the pipeline">
            Signals get pulled, scored against your ICP, and reduced to one lead per person. This
            page becomes that feed.
          </Step>
          <Step n={3} title="Work the leads">
            Each lead gets a three-step sequence written against its own trigger event. Nothing is
            sent — you send it, then mark what happened so{" "}
            <Link href="/activity" className="press underline">
              Activity
            </Link>{" "}
            can report which triggers actually convert.
          </Step>
        </ol>
      </section>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-wash text-[11px] font-medium tabular-nums">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

function SignalRow({ row }: { row: SignalFeedRow }) {
  const kind = row.kind as SignalKind;

  return (
    <article className="card p-4">
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
