import Link from "next/link";
import { Mail, CircleAlert } from "lucide-react";
import { Badge, Empty, PageHeader, ScoreBar, Stat, relativeTime } from "@/components/ui";
import { listLeads, type LeadView } from "@/lib/pipeline";
import { SIGNAL_LABEL, type SignalKind } from "@/lib/signals/types";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const leads = await listLeads();
  const sequenced = leads.filter((l) => l.messages.length > 0);
  const withEmail = leads.filter((l) => l.email);

  return (
    <>
      <PageHeader
        title="Leads"
        sub="Signals that survived ICP filtering, ranked by combined fit and intent."
      />

      {leads.length > 0 && (
        <div className="mb-6 grid grid-cols-3 gap-2">
          <Stat label="Qualified" value={leads.length} />
          <Stat label="With email" value={withEmail.length} />
          <Stat label="Sequenced" value={sequenced.length} />
        </div>
      )}

      <div className="space-y-3">
        {leads.length === 0 ? (
          <Empty title="No qualified leads yet">
            Run the pipeline from the{" "}
            <Link href="/" className="press underline">
              Signals
            </Link>{" "}
            tab. Leads appear here once a signal clears ICP scoring.
          </Empty>
        ) : (
          leads.map((lead) => <LeadCard key={lead.id} lead={lead} />)
        )}
      </div>
    </>
  );
}

function LeadCard({ lead }: { lead: LeadView }) {
  const kind = lead.signal.kind as SignalKind;

  return (
    <article className="card overflow-hidden">
      <div className="p-4">
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
          <div className="shrink-0 text-right">
            <div className="text-2xl font-semibold tabular-nums leading-none">
              {lead.totalScore}
            </div>
            <div className="text-[10px] text-muted">total</div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <ScoreBar label="ICP fit" value={lead.fitScore} />
          <ScoreBar label="Intent" value={lead.intentScore} />
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted">{lead.rationale}</p>
      </div>

      <div className="border-t border-line bg-wash/60 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="solid">{SIGNAL_LABEL[kind] ?? kind}</Badge>
          <Badge tone="quiet">{lead.signal.provider}</Badge>
          <span className="text-[11px] text-muted">
            {relativeTime(lead.signal.detectedAt)}
          </span>
        </div>
        <p className="mt-2 text-xs font-medium leading-snug">{lead.signal.headline}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{lead.signal.evidence}</p>
      </div>

      <div className="border-t border-line p-4">
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
            No verified address — the waterfall came up empty for this contact.
          </p>
        )}

        {lead.messages.length > 0 && (
          <div className="mt-4 space-y-3">
            {lead.messages.map((m) => (
              <div key={m.id} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between text-[11px] text-muted">
                  <span>{m.step === 0 ? "Opening message" : `Follow-up ${m.step}`}</span>
                  <span>{new Date(m.scheduledAt).toISOString().slice(0, 10)}</span>
                </div>
                {m.subject && (
                  <p className="mt-1.5 text-xs font-semibold">Subject: {m.subject}</p>
                )}
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed">{m.body}</p>
              </div>
            ))}
            <p className="text-[11px] text-muted">
              Drafts only — nothing is sent. Wire a sending provider before enabling delivery.
            </p>
          </div>
        )}
      </div>
    </article>
  );
}
