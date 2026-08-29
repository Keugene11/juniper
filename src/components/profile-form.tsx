"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, Wand2 } from "lucide-react";
import type { Profile } from "@/lib/db";

export function ProfileForm({ initial }: { initial: Profile | null }) {
  const router = useRouter();
  const [website, setWebsite] = useState(initial?.website ?? "");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"idle" | "reading" | "finding">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(initial);

  /**
   * Two requests, not one. Reading the site and rebuilding the watchlist from
   * what it says are each a crawl or a model call, and bundling them would put
   * a single request past the serverless ceiling. They are also reported
   * separately, so a discovery failure does not read as though the analysis
   * itself was lost.
   */
  async function infer() {
    setBusy(true);
    setStage("reading");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ website }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setProfile(body.profile as Profile);

      // A new target means new prospects, so the previous target's watchlist is
      // replaced rather than added to. Keeping it is what made every run return
      // the same companies no matter which website was analysed.
      setStage("finding");
      const disc = await fetch("/api/watchlist/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replace: true }),
      });
      const found = await disc.json();
      if (!disc.ok) {
        setError(
          `Profile saved, but finding companies failed: ${found.error ?? disc.status}. ` +
            `Retry from the Watchlist section below.`,
        );
      } else {
        setNotice(describeDiscovery(found.added?.length ?? 0, found.rejected?.length ?? 0));
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStage("idle");
    }
  }

  return (
    <section className="card p-4">
      <h2 className="text-sm font-medium">Your targeting profile</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Paste your site. It gets crawled and read to work out what you sell, who buys it, and
        which public phrases to watch for — then the watchlist is rebuilt with real companies
        that match.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && website && !busy && infer()}
          placeholder="acme.com"
          inputMode="url"
          className="flex-1 rounded-full border border-line px-3 py-2.5 text-sm outline-none focus:border-ink"
        />
        <button
          onClick={infer}
          disabled={busy || !website.trim()}
          className="press flex items-center justify-center gap-2 btn-primary px-4 py-2.5 text-sm"
        >
          {busy ? <Loader2 size={15} className="spinning" /> : <Wand2 size={15} />}
          {stage === "reading"
            ? "Reading site"
            : stage === "finding"
              ? "Finding companies"
              : profile
                ? "Re-analyse"
                : "Analyse"}
        </button>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-2xl bg-wash p-3 text-xs leading-relaxed">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && !error && (
        <p className="mt-3 text-xs leading-relaxed text-muted">{notice}</p>
      )}

      {profile && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <div>
            <p className="text-sm font-medium">{profile.companyName}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{profile.valueProp}</p>
          </div>
          <IcpList label="Buyer titles" items={profile.icp.buyerTitles} />
          <IcpList label="Industries" items={profile.icp.industries} />
          <IcpList label="Company sizes" items={profile.icp.companySizes} />
          <IcpList label="Pain points" items={profile.icp.painPoints} />
          <IcpList label="Disqualifiers" items={profile.icp.disqualifiers} />
          <IcpList label="Live watch terms" items={profile.icp.watchTerms} />
        </div>
      )}
    </section>
  );
}

/**
 * Names the rejects as well as the keeps. A proposed company whose handle
 * matched no live job board is dropped rather than stored, and saying so is
 * what distinguishes "the ICP is too narrow" from "the model guessed badly".
 */
function describeDiscovery(added: number, rejected: number): string {
  if (added === 0) {
    return "No companies with a live job board matched this ICP. Add board handles by hand in the Watchlist section below.";
  }
  const kept = `Watchlist rebuilt: ${added} ${added === 1 ? "company" : "companies"} with a verified job board`;
  return rejected === 0
    ? `${kept}.`
    : `${kept}, ${rejected} dropped for having no board that answered.`;
}

function IcpList({ label, items }: { label: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded-full border border-line px-2 py-0.5 text-xs leading-relaxed"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
