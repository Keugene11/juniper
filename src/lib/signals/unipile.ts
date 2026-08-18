import {
  describeFetchError,
  type ProviderContext,
  type ProviderOutput,
  type Signal,
  type SignalProvider,
} from "./types";

/**
 * LinkedIn engagement via Unipile, an account-based API.
 *
 * ## Why this exists next to the `linkedin` stub
 *
 * `linkedin.ts` refuses to scrape, and that refusal stands. This provider is a
 * different thing: it calls a documented commercial API, against an account
 * *you* connect and control. That distinction is the one LinkedIn's litigation
 * has actually turned on — Proxycurl was sued and shut down in 2025 for
 * operating fake accounts and reselling a scraped profile database, neither of
 * which is happening here. There is no shared dataset; nothing is collected
 * that your own logged-in session could not see.
 *
 * It is still automated access, which the LinkedIn User Agreement prohibits,
 * and the account carrying that risk is your professional identity rather than
 * a vendor's. Unipile throttles to roughly 80-100 actions per account per day
 * for exactly this reason. Enable it knowingly or not at all.
 *
 * ## Configuration
 *
 * UNIPILE_DSN is per-tenant and shown in your dashboard, including the port —
 * e.g. `https://api1.unipile.com:13111`. UNIPILE_API_KEY goes in `X-API-KEY`.
 *
 * Watchlist entries with provider `unipile` take a LinkedIn **post id** as the
 * handle: the competitor announcement, launch, or hiring post whose audience
 * you want to work. Everyone who reacted or commented becomes a
 * `competitor_engagement` signal (weight 95, half-life 5 days).
 *
 * ## Status
 *
 * Written against Unipile's published API reference but **not yet exercised
 * against a live account** — I have no tenant to test with. The response
 * mapping is the part most likely to need a nudge; if items come back but none
 * map, the provider says so in its warnings rather than silently returning an
 * empty feed.
 */

interface UnipileAccount {
  id?: string;
  type?: string;
  provider?: string;
}

/** The subset of a reaction/comment payload this provider actually reads. */
interface UnipileEngagement {
  id?: string;
  date?: string;
  text?: string;
  author?: {
    id?: string;
    provider_id?: string;
    name?: string;
    headline?: string;
    public_identifier?: string;
  };
}

export const unipileProvider: SignalProvider = {
  id: "unipile",
  label: "LinkedIn via Unipile",
  description:
    "Reactions and comments on watched LinkedIn posts, through an account you connect. Automated access is against the LinkedIn User Agreement — your account carries that risk.",
  enabled: true,
  requires: ["UNIPILE_DSN", "UNIPILE_API_KEY"],
  kinds: ["competitor_engagement"],

  async fetch(ctx: ProviderContext): Promise<ProviderOutput> {
    const signals: Signal[] = [];
    const warnings: string[] = [];

    if (ctx.watchlist.length === 0) {
      warnings.push(
        "no watched posts — add LinkedIn post ids on the Setup tab with provider 'unipile'",
      );
      return { signals, warnings };
    }

    let accountId: string;
    try {
      accountId = await linkedInAccountId();
    } catch (err) {
      throw new Error(`Unipile account lookup failed: ${describeFetchError(err)}`);
    }

    let returned = 0;

    for (const target of ctx.watchlist) {
      for (const source of ["reactions", "comments"] as const) {
        let items: UnipileEngagement[];
        try {
          items = await call<{ items?: UnipileEngagement[] }>(
            `/api/v1/posts/${encodeURIComponent(target.handle)}/${source}` +
              `?account_id=${encodeURIComponent(accountId)}&limit=${Math.min(ctx.limit, 50)}`,
          ).then((b) => b.items ?? []);
        } catch (err) {
          warnings.push(`${target.label} ${source}: ${describeFetchError(err)}`);
          continue;
        }

        returned += items.length;

        for (const item of items) {
          const author = item.author;
          const personId = author?.provider_id ?? author?.id ?? author?.public_identifier;
          if (!author?.name || !personId) continue;

          signals.push({
            provider: "unipile",
            kind: "competitor_engagement",
            // The person is the lead here; `company` is best-effort from their
            // headline, since the engagement payload carries no employer field.
            company: companyFromHeadline(author.headline) ?? author.name,
            domain: null,
            personName: author.name,
            personTitle: author.headline ?? null,
            headline:
              source === "comments"
                ? `${author.name} commented on ${target.label}`
                : `${author.name} reacted to ${target.label}`,
            evidence:
              source === "comments" && item.text
                ? `Commented on ${target.label}: "${collapse(item.text).slice(0, 240)}"`
                : `Reacted to ${target.label} — a public signal that they are following this topic.`,
            url: author.public_identifier
              ? `https://www.linkedin.com/in/${author.public_identifier}`
              : null,
            detectedAt: new Date().toISOString(),
            // Comments carry a date; reactions generally do not. Null falls back
            // to detection time in scoring, which is defensible here because the
            // dedupe key is stable — a given person's reaction is ingested once,
            // so "when we first saw it" is the tightest bound available.
            occurredAt: item.date ?? null,
            dedupeKey: `unipile:${source}:${target.handle}:${personId}`,
          });
        }
      }
    }

    if (returned > 0 && signals.length === 0) {
      warnings.push(
        `Unipile returned ${returned} items but none matched the expected author shape — ` +
          "their API reference may have moved; see src/lib/signals/unipile.ts",
      );
    }

    return { signals, warnings };
  },
};

// ------------------------------------------------------------------ transport

async function call<T>(path: string): Promise<T> {
  const dsn = process.env.UNIPILE_DSN!.replace(/\/$/, "");
  const res = await fetch(`${dsn}${path}`, {
    headers: { "X-API-KEY": process.env.UNIPILE_API_KEY!, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}` +
        (res.status === 401 ? " — check UNIPILE_API_KEY" : "") +
        (res.status === 404 ? " — check UNIPILE_DSN (it includes a port) and the post id" : ""),
    );
  }
  return (await res.json()) as T;
}

/**
 * Unipile fronts several messaging providers behind one tenant, so the LinkedIn
 * account has to be picked out of the list rather than assumed.
 */
async function linkedInAccountId(): Promise<string> {
  const body = await call<{ items?: UnipileAccount[] }>("/api/v1/accounts");
  const accounts = body.items ?? [];
  const linkedin = accounts.find((a) =>
    [a.type, a.provider].some((v) => v?.toUpperCase() === "LINKEDIN"),
  );
  if (!linkedin?.id) {
    throw new Error(
      accounts.length === 0
        ? "no accounts connected — connect a LinkedIn account in the Unipile dashboard first"
        : "no LinkedIn account among the connected accounts",
    );
  }
  return linkedin.id;
}

/** "VP Sales at Northwind" -> "Northwind". Best-effort; null when unclear. */
function companyFromHeadline(headline: string | undefined): string | null {
  if (!headline) return null;
  const m = /\bat\s+(.+)$/i.exec(headline);
  const company = m?.[1]?.split(/[|·•]/)[0]?.trim();
  return company && company.length > 1 ? company : null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
