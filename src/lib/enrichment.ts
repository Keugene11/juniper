import { resolveMx } from "node:dns/promises";

export interface EnrichmentResult {
  email: string | null;
  source: string;
  confidence: number;
  /** Every provider tried, in order, with what it returned. */
  trail: { provider: string; outcome: string }[];
}

export interface EnrichmentInput {
  personName: string | null;
  domain: string | null;
}

interface EmailHit {
  email: string;
  confidence: number;
  /** Extra context for the trail, e.g. why confidence is capped. */
  note?: string;
}

interface EmailProvider {
  id: string;
  available(): boolean;
  find(input: EnrichmentInput): Promise<EmailHit | null>;
}

/**
 * "Email waterfall": query providers in order until one returns a usable
 * address. Paid providers run first when their keys are present; the pattern
 * inferrer is the always-available floor.
 */
export async function enrichEmail(input: EnrichmentInput): Promise<EnrichmentResult> {
  const trail: EnrichmentResult["trail"] = [];

  if (!input.domain || !input.personName) {
    return {
      email: null,
      source: "none",
      confidence: 0,
      trail: [{ provider: "waterfall", outcome: "skipped — no domain or person name" }],
    };
  }

  for (const provider of PROVIDERS) {
    if (!provider.available()) {
      trail.push({ provider: provider.id, outcome: "skipped — no API key configured" });
      continue;
    }
    try {
      const hit = await provider.find(input);
      if (hit) {
        trail.push({
          provider: provider.id,
          outcome: `found (${hit.confidence}% confidence${hit.note ? `, ${hit.note}` : ""})`,
        });
        return { email: hit.email, source: provider.id, confidence: hit.confidence, trail };
      }
      trail.push({ provider: provider.id, outcome: "no match" });
    } catch (err) {
      trail.push({
        provider: provider.id,
        outcome: `error — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { email: null, source: "none", confidence: 0, trail };
}

// ---------------------------------------------------------------- providers

const hunter: EmailProvider = {
  id: "hunter",
  available: () => Boolean(process.env.HUNTER_API_KEY),
  async find({ personName, domain }) {
    const [first, ...rest] = personName!.split(/\s+/);
    const last = rest.at(-1) ?? "";
    const url =
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain!)}` +
      `&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}` +
      `&api_key=${encodeURIComponent(process.env.HUNTER_API_KEY!)}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { email?: string; score?: number } };
    if (!body.data?.email) return null;
    return { email: body.data.email, confidence: body.data.score ?? 70 };
  },
};

const apollo: EmailProvider = {
  id: "apollo",
  available: () => Boolean(process.env.APOLLO_API_KEY),
  async find({ personName, domain }) {
    const [first, ...rest] = personName!.split(/\s+/);
    const res = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.APOLLO_API_KEY! },
      body: JSON.stringify({ first_name: first, last_name: rest.at(-1) ?? "", domain }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { person?: { email?: string } };
    if (!body.person?.email || body.person.email.includes("email_not_unlocked")) return null;
    return { email: body.person.email, confidence: 80 };
  },
};

/**
 * No account required: build the most common corporate address pattern, then
 * confirm the domain actually accepts mail by resolving its MX records. That
 * verifies the domain, not the mailbox — hence the capped confidence.
 */
const patternInference: EmailProvider = {
  id: "pattern+mx",
  available: () => true,
  async find({ personName, domain }) {
    const parts = personName!
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z\s-]/g, "")
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length < 2) return null;

    const email = `${parts[0]}.${parts.at(-1)}@${domain}`;
    const mx = await checkMx(domain!);

    // A domain that provably takes no mail is a dead end. A domain we simply
    // could not check still yields a usable guess, just at lower confidence.
    if (mx === "no-mx") return null;
    if (mx === "has-mx") return { email, confidence: 55, note: "domain accepts mail" };
    return {
      email,
      confidence: 30,
      note: "MX unverified — DNS and DNS-over-HTTPS both unreachable",
    };
  },
};

type MxStatus = "has-mx" | "no-mx" | "unverified";

/**
 * MX lookup with a DNS-over-HTTPS fallback. Plenty of container and corporate
 * networks block outbound port 53, which would otherwise make every lookup look
 * like "this domain accepts no mail" and silently zero out enrichment.
 */
async function checkMx(domain: string): Promise<MxStatus> {
  try {
    return (await resolveMx(domain)).length > 0 ? "has-mx" : "no-mx";
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") return "no-mx";
    return dohCheckMx(domain); // transport failure — try again over 443
  }
}

async function dohCheckMx(domain: string): Promise<MxStatus> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return "unverified";
    const body = (await res.json()) as { Status?: number; Answer?: { type?: number }[] };
    if (body.Status === 3) return "no-mx"; // NXDOMAIN
    if (body.Status !== 0) return "unverified";
    return body.Answer?.some((a) => a.type === 15) ? "has-mx" : "no-mx";
  } catch {
    return "unverified";
  }
}

const PROVIDERS: EmailProvider[] = [hunter, apollo, patternInference];

export const enrichmentProviderStatus = () =>
  PROVIDERS.map((p) => ({ id: p.id, available: p.available() }));
