import { Check, Minus } from "lucide-react";
import { ProfileForm } from "@/components/profile-form";
import { WatchlistManager } from "@/components/watchlist-manager";
import { PageHeader } from "@/components/ui";
import { getProfile, isEphemeral, listWatchlist } from "@/lib/db";
import { enrichmentProviderStatus } from "@/lib/enrichment";
import { PROVIDERS } from "@/lib/signals/registry";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const [profile, watchlist] = await Promise.all([getProfile(), listWatchlist()]);
  const enrichment = enrichmentProviderStatus();

  return (
    <>
      <PageHeader
        title="Setup"
        sub="Define who you sell to, then choose which sources to watch."
      />

      <div className="space-y-4">
        {isEphemeral() && (
          <div className="card border-dashed p-4">
            <p className="text-sm font-semibold">Storage is ephemeral</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              No hosted database is configured, so this deployment writes to the function&apos;s
              own temporary disk. Data is not shared between concurrent requests and is wiped
              on every cold start. Set <code className="rounded bg-wash px-1">TURSO_DATABASE_URL</code>{" "}
              and <code className="rounded bg-wash px-1">TURSO_AUTH_TOKEN</code> to persist it.
            </p>
          </div>
        )}
        <ProfileForm initial={profile} />
        <WatchlistManager initial={watchlist} />

        <section className="card p-4">
          <h2 className="text-sm font-semibold">Signal sources</h2>
          <ul className="mt-3 divide-y divide-line">
            {PROVIDERS.map((p) => (
              <li key={p.id} className="flex items-start gap-3 py-3">
                <StatusDot on={p.enabled} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{p.label}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{p.description}</p>
                </div>
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
