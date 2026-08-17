import {
  describeFetchError,
  type ProviderContext,
  type ProviderOutput,
  type Signal,
  type SignalProvider,
} from "./types";

interface LeverPosting {
  id: string;
  text: string;
  createdAt: number;
  hostedUrl: string;
  categories?: { team?: string; location?: string };
}

const RECENT_DAYS = 45;
const SPIKE_THRESHOLD = 4;

/** Same hiring-spike logic as Greenhouse, against Lever's public postings API. */
export const leverProvider: SignalProvider = {
  id: "lever",
  label: "Lever job boards",
  description:
    "Public postings API. Detects hiring spikes and newly opened roles for watchlisted companies.",
  enabled: true,

  async fetch(ctx: ProviderContext): Promise<ProviderOutput> {
    const signals: Signal[] = [];
    const warnings: string[] = [];

    if (ctx.watchlist.length === 0) {
      warnings.push("no watchlisted companies — add board handles on the Setup tab");
      return { signals, warnings };
    }

    for (const target of ctx.watchlist) {
      let postings: LeverPosting[];
      try {
        const res = await fetch(
          `https://api.lever.co/v0/postings/${encodeURIComponent(target.handle)}?mode=json`,
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) },
        );
        if (!res.ok) {
          warnings.push(`${target.label}: board "${target.handle}" returned HTTP ${res.status}`);
          continue;
        }
        const body = await res.json();
        postings = Array.isArray(body) ? (body as LeverPosting[]) : [];
      } catch (err) {
        warnings.push(`${target.label}: ${describeFetchError(err)}`);
        continue;
      }

      const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
      const recent = postings.filter((p) => p.createdAt >= cutoff);
      if (recent.length === 0) continue;

      const teams = [...new Set(recent.map((p) => p.categories?.team).filter(Boolean))];

      if (recent.length >= SPIKE_THRESHOLD) {
        signals.push({
          provider: "lever",
          kind: "hiring_spike",
          company: target.label,
          domain: target.domain,
          personName: null,
          personTitle: null,
          headline: `${target.label} opened ${recent.length} roles in the last ${RECENT_DAYS} days`,
          evidence: `Recent openings span ${
            teams.length ? teams.join(", ") : "multiple teams"
          }, including "${recent[0].text}".`,
          url: recent[0].hostedUrl,
          detectedAt: new Date().toISOString(),
          dedupeKey: `lever:spike:${target.handle}:${new Date().toISOString().slice(0, 7)}`,
        });
      } else {
        for (const p of recent.slice(0, ctx.limit)) {
          signals.push({
            provider: "lever",
            kind: "new_role_opened",
            company: target.label,
            domain: target.domain,
            personName: null,
            personTitle: null,
            headline: `${target.label} is hiring a ${p.text}`,
            evidence: `Role "${p.text}"${
              p.categories?.location ? ` (${p.categories.location})` : ""
            } opened on ${new Date(p.createdAt).toISOString().slice(0, 10)}.`,
            url: p.hostedUrl,
            detectedAt: new Date().toISOString(),
            dedupeKey: `lever:job:${target.handle}:${p.id}`,
          });
        }
      }
    }

    return { signals, warnings };
  },
};
