import {
  describeFetchError,
  type ProviderContext,
  type ProviderOutput,
  type Signal,
  type SignalProvider,
} from "./types";

/**
 * Crunchbase v4 search — the real source for `funding_round`, which until now
 * only the simulator produced.
 *
 * Unlike the job-board providers this is not watchlist-driven: you cannot know
 * in advance which company is about to raise, so it pulls every round closed
 * inside the window and lets the ICP scoring stage throw away the ones you
 * cannot sell to. That is a deliberate division of labour — stage 3 exists
 * precisely so cheap sources are allowed to be broad — but it does mean this
 * provider spends more scoring budget per useful lead than Greenhouse does.
 * Keep `perProviderLimit` modest.
 *
 * Needs CRUNCHBASE_API_KEY. Their free tier was withdrawn, so this is a paid
 * source; the key goes in the `X-cb-user-key` header.
 */

interface CbEntity {
  uuid: string;
  properties?: {
    identifier?: { value?: string; permalink?: string };
    short_description?: string;
    website_url?: string;
    last_funding_at?: string;
    last_funding_type?: string;
    last_funding_total?: { value_usd?: number };
    num_employees_enum?: string;
  };
}

const DEFAULT_WINDOW_DAYS = Number(process.env.CRUNCHBASE_WINDOW_DAYS ?? 30);

export const crunchbaseProvider: SignalProvider = {
  id: "crunchbase",
  label: "Crunchbase",
  description:
    "Funding rounds closed in the last 30 days. Not watchlist-driven — ICP scoring does the filtering, so keep the per-provider limit modest.",
  enabled: true,
  requires: ["CRUNCHBASE_API_KEY"],
  kinds: ["funding_round"],

  async fetch(ctx: ProviderContext): Promise<ProviderOutput> {
    const signals: Signal[] = [];
    const warnings: string[] = [];

    const since = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    let entities: CbEntity[];
    try {
      const res = await fetch("https://api.crunchbase.com/v4/data/searches/organizations", {
        method: "POST",
        headers: {
          "X-cb-user-key": process.env.CRUNCHBASE_API_KEY!,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          field_ids: [
            "identifier",
            "short_description",
            "website_url",
            "last_funding_at",
            "last_funding_type",
            "last_funding_total",
            "num_employees_enum",
          ],
          query: [
            {
              type: "predicate",
              field_id: "last_funding_at",
              operator_id: "gte",
              values: [since],
            },
          ],
          order: [{ field_id: "last_funding_at", sort: "desc" }],
          limit: Math.min(ctx.limit, 50),
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        warnings.push(
          `search returned HTTP ${res.status}` +
            (res.status === 401 ? " — check CRUNCHBASE_API_KEY" : "") +
            (res.status === 429 ? " — plan quota exhausted" : ""),
        );
        return { signals, warnings };
      }

      entities = ((await res.json()) as { entities?: CbEntity[] }).entities ?? [];
    } catch (err) {
      warnings.push(describeFetchError(err));
      return { signals, warnings };
    }

    for (const e of entities) {
      const p = e.properties ?? {};
      const name = p.identifier?.value;
      const fundedAt = p.last_funding_at;
      // Both are load-bearing: without a name there is nothing to write to, and
      // without a date the signal would never decay.
      if (!name || !fundedAt) continue;

      const round = p.last_funding_type ? prettyRound(p.last_funding_type) : "a new round";
      const amount = p.last_funding_total?.value_usd;

      signals.push({
        provider: "crunchbase",
        kind: "funding_round",
        company: name,
        domain: hostOf(p.website_url),
        personName: null,
        personTitle: null,
        headline: `${name} raised ${round}${amount ? ` (${usd(amount)})` : ""}`,
        evidence:
          `Closed on ${fundedAt}${amount ? `, ${usd(amount)} total raised` : ""}` +
          `${p.num_employees_enum ? `, ${prettyHeadcount(p.num_employees_enum)} employees` : ""}. ` +
          (p.short_description ?? ""),
        url: p.identifier?.permalink
          ? `https://www.crunchbase.com/organization/${p.identifier.permalink}`
          : null,
        detectedAt: new Date().toISOString(),
        occurredAt: new Date(`${fundedAt}T00:00:00Z`).toISOString(),
        // Includes the date so a later round for the same company is a new
        // signal rather than a duplicate of the last one.
        dedupeKey: `crunchbase:${e.uuid}:${fundedAt}`,
      });
    }

    if (signals.length === 0) {
      warnings.push(`no rounds closed in the last ${DEFAULT_WINDOW_DAYS} days matched`);
    }

    return { signals, warnings };
  },
};

/** `series_b` -> `a Series B`; `seed` -> `a seed round`. */
function prettyRound(type: string): string {
  const m = /^series_([a-z])$/.exec(type);
  if (m) return `a Series ${m[1].toUpperCase()}`;
  if (type === "seed") return "a seed round";
  if (type === "pre_seed") return "a pre-seed round";
  return `a ${type.replace(/_/g, " ")} round`;
}

/** `c_00051_00100` -> `51-100`. */
function prettyHeadcount(enumValue: string): string {
  const m = /^c_(\d+)_(\d+)$/.exec(enumValue);
  if (!m) return enumValue.replace(/^c_/, "").replace(/_/g, "-");
  return `${Number(m[1])}-${Number(m[2])}`;
}

function usd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
