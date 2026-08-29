import {
  describeFetchError,
  type ProviderContext,
  type ProviderOutput,
  type Signal,
  type SignalProvider,
} from "./types";

interface AshbyJob {
  id: string;
  title: string;
  department: string | null;
  team: string | null;
  location: string | null;
  publishedAt: string;
  isListed: boolean;
  jobUrl: string;
}

const RECENT_DAYS = 45;
const SPIKE_THRESHOLD = 5;

/**
 * The job-board endpoint for a handle. Exported so `discovery.ts` verifies a
 * proposed handle against the exact URL this provider will later fetch.
 */
export function boardUrl(handle: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(handle)}`;
}

/**
 * Ashby's posting API, the third public job board worth watching alongside
 * Greenhouse and Lever. It matters because ATS choice correlates with company
 * age: a lot of the companies founded in the last five years — exactly the
 * segment that buys tooling — are on Ashby and therefore invisible to a
 * Greenhouse-and-Lever-only watchlist.
 *
 * Unlike the other two, every posting carries a real `publishedAt`, so the
 * "opened recently" test is about the role rather than the last time anyone
 * touched the record. (Verified live: Ramp, 136 listed roles.)
 */
export const ashbyProvider: SignalProvider = {
  id: "ashby",
  label: "Ashby job boards",
  description:
    "Public posting API. Same hiring-spike logic as Greenhouse and Lever, with a true published-at date per role.",
  enabled: true,
  requires: [],
  kinds: ["hiring_spike", "new_role_opened"],

  async fetch(ctx: ProviderContext): Promise<ProviderOutput> {
    const signals: Signal[] = [];
    const warnings: string[] = [];

    if (ctx.watchlist.length === 0) {
      warnings.push("no watchlisted companies — add board handles on the Setup tab");
      return { signals, warnings };
    }

    for (const target of ctx.watchlist) {
      let jobs: AshbyJob[];
      try {
        const res = await fetch(
          boardUrl(target.handle),
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) },
        );
        if (!res.ok) {
          warnings.push(
            `${target.label}: board "${target.handle}" returned HTTP ${res.status}` +
              (res.status === 404 ? " — check the slug in their jobs.ashbyhq.com URL" : ""),
          );
          continue;
        }
        jobs = ((await res.json()) as { jobs?: AshbyJob[] }).jobs ?? [];
      } catch (err) {
        warnings.push(`${target.label}: ${describeFetchError(err)}`);
        continue;
      }

      const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
      // `isListed: false` postings are drafts or already-closed roles that the
      // API still returns; counting them inflates every spike.
      const recent = jobs.filter((j) => j.isListed && Date.parse(j.publishedAt) >= cutoff);
      if (recent.length === 0) continue;

      const latest = recent.reduce(
        (a, b) => (Date.parse(b.publishedAt) > Date.parse(a.publishedAt) ? b : a),
        recent[0],
      );

      if (recent.length >= SPIKE_THRESHOLD) {
        const departments = [...new Set(recent.map((j) => j.department).filter(Boolean))];
        signals.push({
          provider: "ashby",
          kind: "hiring_spike",
          company: target.label,
          domain: target.domain,
          personName: null,
          personTitle: null,
          headline: `${target.label} opened ${recent.length} roles in the last ${RECENT_DAYS} days`,
          evidence:
            `Recent openings span ${
              departments.length ? departments.join(", ") : "multiple teams"
            }, most recently "${latest.title}" on ${latest.publishedAt.slice(0, 10)}.`,
          url: latest.jobUrl,
          detectedAt: new Date().toISOString(),
          occurredAt: latest.publishedAt,
          dedupeKey: `ashby:spike:${target.handle}:${new Date().toISOString().slice(0, 7)}`,
        });
      } else {
        for (const job of recent.slice(0, ctx.limit)) {
          signals.push({
            provider: "ashby",
            kind: "new_role_opened",
            company: target.label,
            domain: target.domain,
            personName: null,
            personTitle: null,
            headline: `${target.label} is hiring a ${job.title.trim()}`,
            evidence: `Role "${job.title.trim()}"${
              job.location ? ` (${job.location})` : ""
            } was published on ${job.publishedAt.slice(0, 10)}${
              job.team ? ` on the ${job.team} team` : ""
            }.`,
            url: job.jobUrl,
            detectedAt: new Date().toISOString(),
            occurredAt: job.publishedAt,
            dedupeKey: `ashby:job:${target.handle}:${job.id}`,
          });
        }
      }
    }

    return { signals, warnings };
  },
};
