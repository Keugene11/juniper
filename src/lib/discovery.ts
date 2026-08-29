import { jsonCall } from "./claude";
import type { Profile } from "./db";
import { boardUrl as ashbyBoardUrl } from "./signals/ashby";
import { boardUrl as greenhouseBoardUrl } from "./signals/greenhouse";
import { boardUrl as leverBoardUrl } from "./signals/lever";

/**
 * Turns an ICP into a watchlist of real, verified companies.
 *
 * The job-board providers can only look at companies someone put on the
 * watchlist — there is no public index of "every company on Greenhouse" to
 * search. Before this existed the watchlist came from a hardcoded seed, so
 * every install watched the same four companies regardless of whose website
 * the profile was inferred from, and the largest of those boards dominated
 * every run.
 *
 * Two stages, and the second is the important one: Claude proposes companies
 * and guesses their board slug, then every guess is checked against the live
 * board API. Unverified guesses are discarded rather than stored, because a
 * wrong handle in the watchlist is invisible — it just produces a 404 warning
 * forever while the company it was supposed to represent is never watched.
 */

/** A board that answered. `provider` is whichever ATS actually responded. */
export interface DiscoveredCompany {
  name: string;
  domain: string;
  provider: "greenhouse" | "lever" | "ashby";
  handle: string;
  /** Open roles the board reported, for ranking and for the UI to show. */
  roleCount: number;
  /** One line on why this company fits the ICP. */
  why: string;
}

/** A proposal that no board recognised. Reported, not stored. */
export interface RejectedCompany {
  name: string;
  handle: string;
  reason: string;
}

export interface DiscoveryResult {
  companies: DiscoveredCompany[];
  rejected: RejectedCompany[];
}

/** A proposal from the model, before any of it has been checked. */
export interface Candidate {
  name: string;
  domain: string;
  handle: string;
  why: string;
}

const DEFAULT_LIMIT = 20;
const PROBE_TIMEOUT_MS = 10_000;

export async function discoverCompanies(
  profile: Profile,
  { limit = DEFAULT_LIMIT }: { limit?: number } = {},
): Promise<DiscoveryResult> {
  const candidates = await proposeCandidates(profile, limit);
  return verifyCandidates(candidates);
}

/**
 * Asks for companies that would *buy* what the profile sells. Worth stating
 * explicitly in the prompt: given a value proposition, the likelier completion
 * is a list of competitors, which is the one list guaranteed to be useless.
 */
async function proposeCandidates(profile: Profile, limit: number): Promise<Candidate[]> {
  const { companies } = await jsonCall<{ companies: Candidate[] }>({
    effort: "high",
    system:
      "You build prospecting lists. Given a seller's ideal customer profile, name real, " +
      "currently-operating companies that would plausibly BUY what the seller sells — not " +
      "competitors, and not the seller itself. Every company must be one you are confident " +
      "actually exists, with its real primary domain. Prefer companies that hire publicly " +
      "and are inside the stated employee-count bands. Do not invent companies to reach the " +
      "requested count; a shorter list of real ones is correct.",
    prompt:
      `SELLER: ${profile.companyName} (${profile.website})\n` +
      `WHAT THEY SELL: ${profile.valueProp}\n\n` +
      `ICP\n${JSON.stringify(profile.icp, null, 2)}\n\n` +
      `Name up to ${limit} companies that fit this ICP. For each give:\n` +
      `- name: the company's common name.\n` +
      `- domain: its primary domain, bare (no scheme, no www).\n` +
      `- handle: its applicant-tracking board slug — the identifier in a\n` +
      `  boards.greenhouse.io/<slug>, jobs.lever.co/<slug>, or jobs.ashbyhq.com/<slug> URL.\n` +
      `  This is usually the company name lowercased with spaces and punctuation removed.\n` +
      `  Guess it from the name; which of the three systems they use will be checked\n` +
      `  against the live boards, so do not try to work that out.\n` +
      `- why: one sentence naming the specific ICP attribute this company matches.`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["companies"],
      properties: {
        companies: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "domain", "handle", "why"],
            properties: {
              name: { type: "string" },
              domain: { type: "string" },
              handle: { type: "string" },
              why: { type: "string" },
            },
          },
        },
      },
    },
  });

  return companies.slice(0, limit);
}

/**
 * Probes all three boards for every candidate concurrently, and keeps only the
 * ones that answered.
 *
 * Deliberately does not ask the model which ATS a company uses: that is exactly
 * the kind of fact it has no reliable way to know, and a wrong answer is
 * indistinguishable from a company that simply is not hiring. Trying all three
 * costs three cheap unauthenticated GETs and turns a guess into an observation.
 *
 * Exported separately from `discoverCompanies` because this is the half that
 * decides what reaches the watchlist, and it needs no model call to exercise.
 */
export async function verifyCandidates(candidates: Candidate[]): Promise<DiscoveryResult> {
  const companies: DiscoveredCompany[] = [];
  const rejected: RejectedCompany[] = [];

  const checked = await Promise.all(
    candidates.map(async (c) => ({ candidate: c, hit: await probeAll(c.handle) })),
  );

  const seen = new Set<string>();
  for (const { candidate, hit } of checked) {
    if (!hit) {
      rejected.push({
        name: candidate.name,
        handle: candidate.handle,
        reason: "no Greenhouse, Lever, or Ashby board answered for this handle",
      });
      continue;
    }
    // The same handle can only be watched once — `addWatchlistEntry` is keyed
    // on (provider, handle) — so collapse duplicates here rather than letting
    // the insert silently drop one and leave the counts lying.
    const key = `${hit.provider}:${candidate.handle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    companies.push({
      name: candidate.name,
      domain: normaliseDomain(candidate.domain),
      provider: hit.provider,
      handle: candidate.handle,
      roleCount: hit.roleCount,
      why: candidate.why,
    });
  }

  // Most open roles first: a board with nothing on it produces no hiring
  // signal, so it is the least useful thing on the watchlist.
  companies.sort((a, b) => b.roleCount - a.roleCount);
  return { companies, rejected };
}

interface BoardHit {
  provider: "greenhouse" | "lever" | "ashby";
  roleCount: number;
}

const PROBES: {
  provider: "greenhouse" | "lever" | "ashby";
  url: (handle: string) => string;
  count: (body: unknown) => number;
}[] = [
  {
    provider: "greenhouse",
    url: greenhouseBoardUrl,
    count: (b) => (b as { jobs?: unknown[] })?.jobs?.length ?? 0,
  },
  {
    provider: "lever",
    url: leverBoardUrl,
    count: (b) => (Array.isArray(b) ? b.length : 0),
  },
  {
    provider: "ashby",
    url: ashbyBoardUrl,
    count: (b) => (b as { jobs?: unknown[] })?.jobs?.length ?? 0,
  },
];

/**
 * First board that answers with at least one role wins. A board that responds
 * but lists nothing is treated as a miss: it is real, but it cannot produce the
 * hiring signal the watchlist exists to collect, and keeping it would fill the
 * list with entries that never fire.
 */
async function probeAll(handle: string): Promise<BoardHit | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(handle)) return null;

  const results = await Promise.all(
    PROBES.map(async (p): Promise<BoardHit | null> => {
      try {
        const res = await fetch(p.url(handle), {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const roleCount = p.count(await res.json());
        return roleCount > 0 ? { provider: p.provider, roleCount } : null;
      } catch {
        return null;
      }
    }),
  );

  return results.find((r) => r !== null) ?? null;
}

function normaliseDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}
