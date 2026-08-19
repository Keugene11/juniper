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
 * Watchlist entries with provider `unipile` name the competitor announcement,
 * launch, or hiring post whose audience you want to work. Everyone who reacted
 * or commented becomes a `competitor_engagement` signal (weight 95, half-life
 * 5 days). The handle may be the post URL, the numeric id from that URL, or the
 * `urn:li:activity:...` social id — see `resolvePostUrn`.
 *
 * ## Status
 *
 * Written against Unipile's published API reference and corrected against it a
 * second time, but still **not exercised against a live account** — there is no
 * tenant to test with. The response mapping remains the part most likely to
 * need a nudge, so it accepts every documented shape rather than betting on
 * one, and the provider reports what it saw in its warnings rather than
 * silently returning an empty feed.
 */

interface UnipileAccount {
  id?: string;
  type?: string;
  provider?: string;
}

/**
 * A person as either endpoint describes them.
 *
 * Reactions and comments do not agree on where the person lives, and neither
 * matches what an earlier reading of the docs assumed. A reaction carries
 * `author` as an object with the name on it and a `type` of INDIVIDUAL or
 * COMPANY. A LinkedIn comment carries `author` as a bare name *string* and puts
 * the rest in `author_details`, with no type at all. Neither carries
 * `public_identifier`; the profile link is `profile_url`.
 */
interface UnipileAuthor {
  id?: string;
  provider_id?: string;
  /** INDIVIDUAL or COMPANY. Absent on comment authors. */
  type?: string;
  name?: string;
  headline?: string;
  profile_url?: string;
  public_identifier?: string;
}

/** The subset of a reaction/comment payload this provider actually reads. */
interface UnipileEngagement {
  id?: string;
  date?: string;
  text?: string;
  author?: UnipileAuthor | string | null;
  author_details?: UnipileAuthor;
}

interface Person {
  id: string;
  name: string;
  headline: string | null;
  profileUrl: string | null;
  isCompany: boolean;
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
        "no watched posts — add LinkedIn post URLs on the Setup tab with provider 'unipile'",
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
    let companies = 0;

    for (const target of ctx.watchlist) {
      let postId: string;
      try {
        postId = await resolvePostUrn(target.handle, accountId);
      } catch (err) {
        warnings.push(`${target.label}: ${describeFetchError(err)}`);
        continue;
      }

      for (const source of ["reactions", "comments"] as const) {
        let items: UnipileEngagement[];
        try {
          items = await call<{ items?: UnipileEngagement[] }>(
            `/api/v1/posts/${encodeURIComponent(postId)}/${source}` +
              `?account_id=${encodeURIComponent(accountId)}&limit=${Math.min(ctx.limit, 50)}`,
          ).then((b) => b.items ?? []);
        } catch (err) {
          warnings.push(`${target.label} ${source}: ${describeFetchError(err)}`);
          continue;
        }

        returned += items.length;

        for (const item of items) {
          const person = personFrom(item);
          if (!person) continue;

          // A company page reacting is not a lead: there is no one to write to,
          // and letting it through would put the company's own name in the
          // person field and sequence it like a human.
          if (person.isCompany) {
            companies++;
            continue;
          }

          signals.push({
            provider: "unipile",
            kind: "competitor_engagement",
            // The person is the lead here; `company` is best-effort from their
            // headline, since the engagement payload carries no employer field.
            company: companyFromHeadline(person.headline) ?? person.name,
            domain: null,
            personName: person.name,
            personTitle: person.headline,
            headline:
              source === "comments"
                ? `${person.name} commented on ${target.label}`
                : `${person.name} reacted to ${target.label}`,
            evidence:
              source === "comments" && item.text
                ? `Commented on ${target.label}: "${collapse(item.text).slice(0, 240)}"`
                : `Reacted to ${target.label} — a public signal that they are following this topic.`,
            url: person.profileUrl,
            detectedAt: new Date().toISOString(),
            // Comments carry a date; reactions generally do not. Null falls back
            // to detection time in scoring, which is defensible here because the
            // dedupe key is stable — a given person's reaction is ingested once,
            // so "when we first saw it" is the tightest bound available.
            occurredAt: item.date ?? null,
            // Keyed on the resolved urn rather than the pasted handle, so the
            // same post added twice in different formats does not double-count.
            dedupeKey: `unipile:${source}:${postId}:${person.id}`,
          });
        }
      }
    }

    if (companies > 0) {
      warnings.push(`${companies} company page${companies === 1 ? "" : "s"} skipped — not people`);
    }
    if (returned > 0 && signals.length === 0 && companies === 0) {
      warnings.push(
        `Unipile returned ${returned} items but none matched the expected author shape — ` +
          "their API reference may have moved; see src/lib/signals/unipile.ts",
      );
    }

    return { signals, warnings };
  },
};

// ------------------------------------------------------------------- mapping

/**
 * Pull one person out of either payload shape.
 *
 * Returns null rather than throwing when the shape is unrecognised, so a single
 * odd row cannot take down a whole run; the caller counts what it dropped and
 * reports it.
 */
function personFrom(item: UnipileEngagement): Person | null {
  const details: UnipileAuthor | undefined =
    typeof item.author === "object" && item.author !== null ? item.author : item.author_details;

  // Comments put the display name where reactions put the whole object.
  const name = (typeof item.author === "string" ? item.author : details?.name)?.trim();
  const id = details?.provider_id ?? details?.id ?? details?.public_identifier;
  if (!name || !id) return null;

  return {
    id,
    name,
    headline: details?.headline?.trim() || null,
    profileUrl:
      details?.profile_url ??
      (details?.public_identifier
        ? `https://www.linkedin.com/in/${details.public_identifier}`
        : null),
    isCompany: details?.type?.toUpperCase() === "COMPANY",
  };
}

/** "VP Sales at Northwind" -> "Northwind". Best-effort; null when unclear. */
function companyFromHeadline(headline: string | null): string | null {
  if (!headline) return null;
  const m = /\bat\s+(.+)$/i.exec(headline);
  const company = m?.[1]?.split(/[|·•]/)[0]?.trim();
  return company && company.length > 1 ? company : null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- post ids

/**
 * Resolved social ids, kept across runs because a post's urn never changes.
 * Small and bounded by the size of the watchlist.
 */
const urnCache = new Map<string, string>();

/**
 * Unipile addresses posts by LinkedIn's *social id* — `urn:li:activity:...` —
 * and not by the number in the post URL. Watchlist handles are typed by hand
 * from a browser address bar, so accept what someone actually has and resolve
 * it once, rather than making them hand-build a urn and discover the mistake as
 * a 404 halfway through a run.
 */
async function resolvePostUrn(handle: string, accountId: string): Promise<string> {
  const raw = handle.trim();
  if (/^urn:li:/i.test(raw)) return raw;

  const cached = urnCache.get(raw);
  if (cached) return cached;

  // `.../feed/update/urn:li:activity:7332661864792854528/`, `...-activity-7332661864792854528-x1y2`,
  // or a bare id pasted on its own. LinkedIn post ids are 19 digits today; the
  // looser bound leaves room for that to change.
  const numeric =
    /(?:activity|ugcPost|share)[:-](\d{5,})/i.exec(raw)?.[1] ?? /^\s*(\d{10,})\s*$/.exec(raw)?.[1];
  if (!numeric) {
    throw new Error(`"${raw}" is not a LinkedIn post URL, numeric id, or urn:li: social id`);
  }

  const post = await call<{ social_id?: string; id?: string }>(
    `/api/v1/posts/${encodeURIComponent(numeric)}?account_id=${encodeURIComponent(accountId)}`,
  );
  const urn = post.social_id ?? post.id;
  if (!urn) {
    throw new Error(`Unipile returned no social id for post ${numeric}`);
  }

  urnCache.set(raw, urn);
  return urn;
}

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
