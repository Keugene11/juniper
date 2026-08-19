import { unipileProvider } from "../src/lib/signals/unipile";

/**
 * Drives the provider against stubbed responses shaped like Unipile's
 * published reference, since there is no live tenant to test with.
 */
process.env.UNIPILE_DSN = "https://api1.unipile.com:13111";
process.env.UNIPILE_API_KEY = "test-key";

let failures = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === "" ? "" : `  → ${detail}`}`);
  if (!ok) failures++;
};

const calls: string[] = [];

globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  calls.push(u.replace("https://api1.unipile.com:13111", ""));
  const json = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  if (u.includes("/api/v1/accounts")) {
    return json({ items: [{ id: "acct_1", type: "LINKEDIN" }] });
  }

  // Retrieve-post: numeric id in, social id out.
  if (/\/api\/v1\/posts\/7332661864792854528\?/.test(u)) {
    return json({ social_id: "urn:li:activity:7332661864792854528", id: "internal_1" });
  }

  if (u.includes("/reactions")) {
    return json({
      object: "PostReactionList",
      items: [
        {
          object: "PostReaction",
          value: "LIKE",
          author: {
            id: "person_a",
            type: "INDIVIDUAL",
            name: "Dana Whitfield",
            headline: "VP Sales at Northwind | Ex-Acme",
            profile_url: "https://www.linkedin.com/in/dana-whitfield",
            network_distance: "SECOND_DEGREE",
          },
        },
        {
          object: "PostReaction",
          value: "PRAISE",
          author: {
            id: "company_z",
            type: "COMPANY",
            name: "Northwind Traders",
            headline: null,
            profile_url: "https://www.linkedin.com/company/northwind",
          },
        },
      ],
    });
  }

  if (u.includes("/comments")) {
    // LinkedIn comment shape: author is a bare string, details live alongside.
    return json({
      object: "CommentList",
      items: [
        {
          id: "comment_1",
          text: "We hit exactly this problem last quarter.",
          date: "2026-08-17T09:30:00.000Z",
          author: "Priya Raman",
          author_details: {
            id: "person_b",
            headline: "Head of RevOps at Contoso",
            profile_url: "https://www.linkedin.com/in/priya-raman",
            network_distance: "THIRD_DEGREE",
          },
        },
      ],
    });
  }

  throw new Error(`unexpected call: ${u}`);
}) as typeof fetch;

const out = await unipileProvider.fetch({
  watchlist: [
    {
      provider: "unipile",
      // A URL straight from the address bar — the format someone actually has.
      handle: "https://www.linkedin.com/feed/update/urn:li:activity:7332661864792854528/",
      label: "Competitor launch post",
      domain: null,
    },
  ],
  keywords: [],
  limit: 25,
});

check("resolved the numeric id to a social urn", calls.some((c) => c.startsWith("/api/v1/posts/7332661864792854528?")), calls[1]);
check(
  "engagement fetched against the urn",
  calls.some((c) => c.includes(encodeURIComponent("urn:li:activity:7332661864792854528"))),
);
check("two people mapped, company dropped", out.signals.length === 2, out.signals.length);

const reaction = out.signals.find((s) => s.headline.includes("reacted"));
check("reaction author name", reaction?.personName === "Dana Whitfield", reaction?.personName);
check(
  "reaction profile link uses profile_url",
  reaction?.url === "https://www.linkedin.com/in/dana-whitfield",
  reaction?.url,
);
check("company parsed from headline", reaction?.company === "Northwind", reaction?.company);

const comment = out.signals.find((s) => s.headline.includes("commented"));
check("comment author from bare string", comment?.personName === "Priya Raman", comment?.personName);
check(
  "comment details from author_details",
  comment?.url === "https://www.linkedin.com/in/priya-raman" &&
    comment?.personTitle === "Head of RevOps at Contoso",
  `${comment?.url} / ${comment?.personTitle}`,
);
check("comment carries a real occurredAt", comment?.occurredAt === "2026-08-17T09:30:00.000Z", comment?.occurredAt);
check("reaction has no occurredAt", reaction?.occurredAt === null, String(reaction?.occurredAt));
check(
  "dedupe keys are stable and distinct",
  new Set(out.signals.map((s) => s.dedupeKey)).size === 2 &&
    out.signals.every((s) => s.dedupeKey.includes("urn:li:activity:")),
  out.signals.map((s) => s.dedupeKey).join(" | "),
);
check("company skip reported as a warning", out.warnings.some((w) => w.includes("company page")), out.warnings.join("; "));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
