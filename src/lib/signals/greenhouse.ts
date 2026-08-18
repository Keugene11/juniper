import {
  describeFetchError,
  type ProviderContext,
  type ProviderOutput,
  type Signal,
  type SignalProvider,
} from "./types";

interface GreenhouseJob {
  id: number;
  title: string;
  updated_at: string;
  absolute_url: string;
  location?: { name?: string };
}

const RECENT_DAYS = 45;
const SPIKE_THRESHOLD = 5;

/**
 * Greenhouse publishes every customer's job board as unauthenticated JSON.
 * A cluster of recently-opened roles is the cleanest public proxy for
 * "this team is growing and has budget" — the hiring-spike signal.
 */
export const greenhouseProvider: SignalProvider = {
  id: "greenhouse",
  label: "Greenhouse job boards",
  description:
    "Public job-board JSON. Detects hiring spikes and newly opened roles for watchlisted companies.",
  enabled: true,
  requires: [],
  kinds: ["hiring_spike", "new_role_opened"],

  async fetch(ctx: ProviderContext): Promise<ProviderOutput> {
    const signals: Signal[] = [];
    const warnings: string[] = [];

    const targets = ctx.watchlist;
    if (targets.length === 0) {
      warnings.push("no watchlisted companies — add board handles on the Setup tab");
      return { signals, warnings };
    }

    for (const target of targets) {
      let jobs: GreenhouseJob[];
      try {
        const res = await fetch(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.handle)}/jobs`,
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) },
        );
        if (!res.ok) {
          warnings.push(
            `${target.label}: board "${target.handle}" returned HTTP ${res.status}` +
              (res.status === 404 ? " — check the handle in their board URL" : ""),
          );
          continue;
        }
        jobs = ((await res.json()) as { jobs?: GreenhouseJob[] }).jobs ?? [];
      } catch (err) {
        warnings.push(`${target.label}: ${describeFetchError(err)}`);
        continue;
      }

      const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
      const recent = jobs.filter((j) => Date.parse(j.updated_at) >= cutoff);
      if (recent.length === 0) continue;

      if (recent.length >= SPIKE_THRESHOLD) {
        const titles = recent.slice(0, 6).map((j) => j.title);
        // The spike is as fresh as its most recent opening.
        const latest = recent.reduce(
          (a, b) => (Date.parse(b.updated_at) > Date.parse(a.updated_at) ? b : a),
          recent[0],
        );
        signals.push({
          provider: "greenhouse",
          kind: "hiring_spike",
          company: target.label,
          domain: target.domain,
          personName: null,
          personTitle: null,
          headline: `${target.label} opened ${recent.length} roles in the last ${RECENT_DAYS} days`,
          evidence: `Currently hiring for: ${titles.join(", ")}${
            recent.length > titles.length ? `, +${recent.length - titles.length} more` : ""
          }.`,
          url: recent[0].absolute_url,
          detectedAt: new Date().toISOString(),
          occurredAt: latest.updated_at,
          dedupeKey: `greenhouse:spike:${target.handle}:${monthStamp()}`,
        });
      } else {
        for (const job of recent.slice(0, ctx.limit)) {
          signals.push({
            provider: "greenhouse",
            kind: "new_role_opened",
            company: target.label,
            domain: target.domain,
            personName: null,
            personTitle: null,
            headline: `${target.label} is hiring a ${job.title}`,
            evidence: `Role "${job.title}"${
              job.location?.name ? ` (${job.location.name})` : ""
            } was posted or updated on ${job.updated_at.slice(0, 10)}.`,
            url: job.absolute_url,
            detectedAt: new Date().toISOString(),
            occurredAt: job.updated_at,
            dedupeKey: `greenhouse:job:${target.handle}:${job.id}`,
          });
        }
      }
    }

    return { signals, warnings };
  },
};

const monthStamp = () => new Date().toISOString().slice(0, 7);
