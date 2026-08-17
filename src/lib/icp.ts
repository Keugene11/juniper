import { jsonCall } from "./claude";
import type { Icp } from "./db";

const PAGES = ["", "/about", "/product", "/pricing", "/customers", "/solutions"];
const MAX_CHARS = 14_000;

export interface InferredProfile {
  companyName: string;
  valueProp: string;
  icp: Icp;
}

/**
 * The onboarding step: paste a URL, get a targeting profile. Crawls a handful
 * of high-signal pages, strips them to text, and has Claude reverse-engineer
 * what the company sells and who it sells to.
 */
export async function inferProfileFromWebsite(website: string): Promise<InferredProfile> {
  const base = normaliseUrl(website);
  const text = await crawl(base);

  if (text.length < 200) {
    throw new Error(
      `Fetched ${base} but found almost no readable text. If the site is client-rendered, enter the profile manually.`,
    );
  }

  return jsonCall<InferredProfile>({
    effort: "high",
    system:
      "You analyse a company's own website and produce a B2B targeting profile. " +
      "Ground every field in what the page text actually says. Where the site is " +
      "vague, infer the most probable answer for a company of this kind rather than " +
      "returning empty lists.",
    prompt:
      `Website: ${base}\n\n` +
      `--- PAGE TEXT ---\n${text}\n--- END ---\n\n` +
      `Produce:\n` +
      `- companyName and a one-sentence valueProp written the way a salesperson would say it.\n` +
      `- icp.segments: the customer segments they sell to.\n` +
      `- icp.companySizes: employee-count bands, e.g. "50-200".\n` +
      `- icp.industries, icp.buyerTitles: the roles that actually sign.\n` +
      `- icp.painPoints: problems the buyer feels before they buy.\n` +
      `- icp.disqualifiers: traits that make a company a bad fit.\n` +
      `- icp.watchTerms: 4-8 short search phrases someone would post publicly when ` +
      `they have one of these pain points. These are used as live search queries, so ` +
      `keep them concrete and 2-5 words each.`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["companyName", "valueProp", "icp"],
      properties: {
        companyName: { type: "string" },
        valueProp: { type: "string" },
        icp: {
          type: "object",
          additionalProperties: false,
          required: [
            "segments",
            "companySizes",
            "industries",
            "buyerTitles",
            "painPoints",
            "disqualifiers",
            "watchTerms",
          ],
          properties: {
            segments: { type: "array", items: { type: "string" } },
            companySizes: { type: "array", items: { type: "string" } },
            industries: { type: "array", items: { type: "string" } },
            buyerTitles: { type: "array", items: { type: "string" } },
            painPoints: { type: "array", items: { type: "string" } },
            disqualifiers: { type: "array", items: { type: "string" } },
            watchTerms: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  });
}

async function crawl(base: string): Promise<string> {
  const chunks: string[] = [];

  const results = await Promise.all(
    PAGES.map(async (path) => {
      try {
        const res = await fetch(base + path, {
          headers: { "user-agent": "JuniperBot/0.1 (+signal-based prospecting)" },
          signal: AbortSignal.timeout(10_000),
          redirect: "follow",
        });
        if (!res.ok) return null;
        const type = res.headers.get("content-type") ?? "";
        if (!type.includes("text/html") && !type.includes("text/plain")) return null;
        return { path, text: htmlToText(await res.text()) };
      } catch {
        return null;
      }
    }),
  );

  for (const r of results) {
    if (!r || r.text.length < 80) continue;
    chunks.push(`## ${r.path || "/"}\n${r.text}`);
  }

  return chunks.join("\n\n").slice(0, MAX_CHARS);
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|section|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export function normaliseUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}`;
}
