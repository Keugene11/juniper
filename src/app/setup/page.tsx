import { Check, Minus } from "lucide-react";
import { ProfileForm } from "@/components/profile-form";
import { SuppressionManager } from "@/components/suppression-manager";
import { WatchlistManager } from "@/components/watchlist-manager";
import { PageHeader } from "@/components/ui";
import { getProfile, isUnconfigured, listSuppressions, listWatchlist } from "@/lib/db";
import { enrichmentProviderStatus } from "@/lib/enrichment";
import { outboundTargetStatus } from "@/lib/outbound";
import { providerStatus } from "@/lib/signals/registry";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const [profile, watchlist, suppressions] = await Promise.all([
    getProfile(),
    listWatchlist(),
    listSuppressions(),
  ]);
  const enrichment = enrichmentProviderStatus();
  const sources = providerStatus();
  const outbound = outboundTargetStatus();

  return (
    <>
      <PageHeader
        title="Setup"
        sub="Define who you sell to, then choose which sources to watch."
      />

      <div className="space-y-4">
        {isUnconfigured() && (
          <div className="card border-dashed p-4">
            <p className="text-sm font-semibold">No database configured</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Nothing can be saved or read until a database is reachable. Set{" "}
              <code className="rounded bg-wash px-1">DATABASE_URL</code> to a Neon Postgres
              connection string — every page on this tab will fail its first query until
              you do.
            </p>
          </div>
        )}
        <ProfileForm initial={profile} />
        <WatchlistManager initial={watchlist} />
        <SuppressionManager initial={suppressions} />

        <section className="card p-4">
          <h2 className="text-sm font-semibold">Signal sources</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            A source that needs credentials stays listed and names the variable it wants — an
            unconfigured source that quietly vanished would be indistinguishable from one that
            ran and found nothing.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {sources.map((p) => (
              <li key={p.id} className="flex items-start gap-3 py-3">
                <StatusDot on={p.enabled && p.configured} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{p.label}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{p.description}</p>
                  {p.enabled && !p.configured && (
                    <p className="mt-1 text-[11px] text-muted">
                      Needs{" "}
                      {p.missing.map((k, i) => (
                        <span key={k}>
                          {i > 0 && ", "}
                          <code className="rounded bg-wash px-1">{k}</code>
                        </span>
                      ))}{" "}
                      in <code className="rounded bg-wash px-1">.env</code>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-4">
          <h2 className="text-sm font-semibold">Outbound destinations</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Where a finished lead gets pushed. Unlike the email waterfall these are not
            alternatives to each other — every configured destination receives every pushed
            lead, and each reports its own result. Pushing is manual by default; set{" "}
            <code className="rounded bg-wash px-1">JUNIPER_AUTO_PUSH=1</code> to push during a
            run.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {outbound.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2.5">
                <StatusDot on={t.available} />
                <span className="text-sm">{t.label}</span>
                <span className="ml-auto text-[11px] text-muted">
                  {t.available ? "ready" : t.missing.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-4">
          <h2 className="text-sm font-semibold">Email waterfall</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Tried in order until one returns an address. Pattern inference needs no account: it
            builds the common corporate format and confirms the domain accepts mail via MX
            lookup, which verifies the domain rather than the mailbox.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {enrichment.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2.5">
                <StatusDot on={p.available} />
                <span className="text-sm">{p.id}</span>
                <span className="ml-auto text-[11px] text-muted">
                  {p.available ? "ready" : "add API key in .env"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${
        on ? "bg-ink text-paper" : "bg-wash text-muted"
      }`}
    >
      {on ? <Check size={10} strokeWidth={3} /> : <Minus size={10} strokeWidth={3} />}
    </span>
  );
}
