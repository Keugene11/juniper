import Link from "next/link";
import { Mail, CircleAlert, ShieldOff, UserX } from "lucide-react";
import { OutcomeControl } from "@/components/outcome-control";
import { ProfileForm } from "@/components/profile-form";
import { PushControl } from "@/components/push-control";
import { RunButton } from "@/components/run-button";
import { TargetBar } from "@/components/target-bar";
import {
  Badge,
  Empty,
  FreshnessTag,
  PageHeader,
  ScoreBar,
  ScoreDial,
  relativeTime,
} from "@/components/ui";
import { getProfile } from "@/lib/db";
import { outboundConfigured } from "@/lib/outbound";
import { listLeads, type LeadView } from "@/lib/pipeline";
import { SIGNAL_LABEL, type SignalKind } from "@/lib/signals/types";

export const dynamic = "force-dynamic";

/**
 * The home page is the people to contact, because that is what the tool is for.
 *
 * The raw signal feed lives on its own tab as diagnostics. Leading with it put
 * the engine's input where the output belongs, and left two tabs showing
 * overlapping views of the same rows with nothing saying which one to act on.
 */
export default async function LeadsPage() {
  const profile = await getProfile();

  // Nothing downstream works without an ICP, so the one action that matters is
  // the only thing on the page until it is done.
  if (!profile) return <Onboarding />;

  const [leads, canPush] = await Promise.all([
    listLeads(),
    Promise.resolve(outboundConfigured()),
  ]);

  // Actionability, not score, decides the order here. A 47 you can send today
  // is worth more than a 75 with nobody to send it to, and grouping says why
  // the 75 is stuck instead of leaving you to work it out.
  const ready = leads.filter((l) => l.messages.length > 0);
  const blocked = leads.filter((l) => l.messages.length === 0);

  return (
    <>
      <TargetBar profile={profile} />

      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {leads.length === 0
              ? `Nothing yet. Run the pipeline to find companies showing intent that match ${profile.companyName}'s ICP.`
              : summarise(ready.length, blocked.length)}
          </p>
        </div>
        <div className="shrink-0">
          <RunButton ready />
        </div>
      </div>

      {leads.length === 0 ? (
        <Empty title="No leads yet">
          Press Run. Juniper pulls from your sources, scores what it finds against your ICP, and
          drafts a sequence for anyone worth contacting. Add companies to watch on the{" "}
          <Link href="/setup" className="press underline">
            Setup
          </Link>{" "}
          tab first if you have not already.
        </Empty>
      ) : (
        <div className="space-y-6">
          {ready.length > 0 && (
            <Section title="Ready to send" count={ready.length}>
              {ready.map((lead) => (
                <LeadCard key={lead.id} lead={lead} canPush={canPush} />
              ))}
            </Section>
          )}

          {blocked.length > 0 && (
            <Section
              title="Needs a contact"
              count={blocked.length}
              note="Scored well but nobody to write to yet. Each card says why."
            >
              {blocked.map((lead) => (
                <LeadCard key={lead.id} lead={lead} canPush={canPush} />
              ))}
            </Section>
          )}
        </div>
      )}
    </>
  );
}

function summarise(ready: number, blocked: number): string {
  const parts = [
    ready > 0 ? `${ready} ready to send` : null,
    blocked > 0 ? `${blocked} waiting on a contact` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}.` : "Nothing qualified on the last run.";
}

function Section({
  title,
  count,
  note,
  children,
}: {
  title: string;
  count: number;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs tabular-nums text-muted">{count}</span>
      </div>
      {note && <p className="mb-3 text-xs leading-relaxed text-muted">{note}</p>}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * Why a lead has no copy, in the terms that let you decide what to do about it.
 * "The waterfall came up empty" describes the machine; it does not tell you
 * that the fix is a different source or an enrichment key.
 */
function contactGap(lead: LeadView): string {
  if (lead.skipReason) return lead.skipReason;
  if (!lead.personName) {
    return (
      "This is a company-level event — a hiring spike or a funding round names the company, " +
      "not a person, and an address cannot be guessed without a name. Add an enrichment key " +
      "(HUNTER_API_KEY or APOLLO_API_KEY), or find the right person by hand."
    );
  }
  if (!lead.email) {
    return (
      "No address resolved for this person. The pattern waterfall needs a company domain it " +
      "can verify, and this signal carries none — try the LinkedIn channel instead."
    );
  }
  return "Scored below the threshold on the last run. Lower it and run again to include them.";
}

/** First run. One question — everything else on this page depends on the answer. */
function Onboarding() {
  return (
    <>
      <PageHeader
        title="Start here"
        sub="Juniper watches for public events that mean a company is in-market right now, then writes outreach about that specific event. First it needs to know what you sell."
      />

      <ProfileForm initial={null} />

      <section className="card mt-4 p-5">
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
          <Step n={2} title="Press Run">
            Events get pulled, scored against your ICP, and reduced to one lead per person. This
            page becomes that list.
          </Step>
          <Step n={3} title="Send and report back">
            Each lead gets a three-step sequence written against its own trigger. Nothing is sent
            — you send it, then mark what happened so{" "}
            <Link href="/activity" className="press underline">
              Activity
            </Link>{" "}
            can tell you which triggers actually convert.
          </Step>
        </ol>
      </section>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-wash text-xs font-medium tabular-nums">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

function LeadCard({ lead, canPush }: { lead: LeadView; canPush: boolean }) {
  const kind = lead.signal.kind as SignalKind;
  const sequenced = lead.messages.length > 0;

  return (
    <article className="card overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-snug">
              {lead.personName ?? lead.company}
            </h2>
            <p className="text-xs text-muted">
              {lead.personTitle ? `${lead.personTitle} · ` : ""}
              {lead.company}
              {lead.domain ? ` · ${lead.domain}` : ""}
            </p>
          </div>
          <ScoreDial value={lead.totalScore} />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <ScoreBar label="ICP fit" value={lead.fitScore} />
          {/* Intent is the decayed value as of scoring time; the freshness tag
              below shows how much of it is left now. */}
          <ScoreBar label="Intent" value={lead.intentScore} />
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted">{lead.rationale}</p>
      </div>

      <div className="border-t border-line bg-wash p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="solid">{SIGNAL_LABEL[kind] ?? kind}</Badge>
          <Badge tone="quiet">{lead.signal.provider}</Badge>
          <FreshnessTag value={lead.signal.freshness} />
          <span className="text-xs text-muted">
            {relativeTime(lead.signal.occurredAt ?? lead.signal.detectedAt)}
          </span>
        </div>
        <p className="mt-2 text-xs font-medium leading-snug">{lead.signal.headline}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{lead.signal.evidence}</p>
      </div>

      {/* A lead with no copy was scored and deliberately not written to. Saying
          why on the card is the difference between a considered decision and a
          bug — and the reason names the fix, not just the symptom. */}
      {!sequenced && (
        <div className="border-t border-line bg-wash/60 px-4 py-3">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
            {lead.skipReason ? (
              <ShieldOff size={12} className="mt-0.5 shrink-0" />
            ) : (
              <UserX size={12} className="mt-0.5 shrink-0" />
            )}
            <span>
              <span className="font-medium text-ink">No sequence written</span> —{" "}
              {contactGap(lead)}
            </span>
          </p>
        </div>
      )}

      <div className="border-t border-line p-5">
        {lead.email ? (
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <Mail size={13} className="shrink-0" />
            <span className="font-medium">{lead.email}</span>
            <Badge tone="quiet">
              {lead.emailSource} · {lead.emailConfidence}%
            </Badge>
          </p>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted">
            <CircleAlert size={13} className="shrink-0" />
            No address found
          </p>
        )}

        {sequenced && (
          <div className="mt-4 space-y-3">
            {lead.messages.map((m) => (
              <div key={m.id} className="rounded-xl border border-line p-3">
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>{m.step === 0 ? "Opening message" : `Follow-up ${m.step}`}</span>
                  <span>{new Date(m.scheduledAt).toISOString().slice(0, 10)}</span>
                </div>
                {m.subject && (
                  <p className="mt-1.5 text-xs font-semibold">Subject: {m.subject}</p>
                )}
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed">{m.body}</p>
              </div>
            ))}
            <p className="text-xs text-muted">
              Drafts only — nothing is sent. Copy them into your own inbox, then mark what
              happened below.
            </p>
          </div>
        )}

        <div className="mt-4 space-y-4 border-t border-line pt-4">
          <OutcomeControl leadId={lead.id} initial={lead.outcome} />
          <PushControl
            leadId={lead.id}
            configured={canPush}
            pushedAt={lead.pushedAt}
            initial={lead.pushResult}
          />
        </div>
      </div>
    </article>
  );
}
