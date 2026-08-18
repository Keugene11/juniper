/**
 * Writes a profile and watchlist straight to SQLite so the app is usable —
 * and the pipeline demoable — before you have an Anthropic key.
 *
 *   node scripts/seed.ts
 *
 * Running `Analyse` on the Setup tab replaces the profile with a real one
 * inferred from your own website.
 */
import { addWatchlistEntry, getProfile, listWatchlist, saveProfile } from "../src/lib/db";

await saveProfile({
  website: "https://example-seller.com",
  companyName: "Example Seller",
  valueProp:
    "Revenue-operations tooling that stitches CRM, product usage, and billing into one pipeline view for mid-market B2B sales teams.",
  icp: {
    segments: ["Mid-market B2B SaaS", "Usage-based software"],
    companySizes: ["50-200", "200-1000"],
    industries: ["Software", "Fintech", "Logistics tech"],
    buyerTitles: [
      "VP of Revenue Operations",
      "Head of Growth",
      "Chief Revenue Officer",
      "Director of Demand Generation",
    ],
    painPoints: [
      "pipeline data scattered across tools",
      "manual CRM hygiene",
      "no view of product usage at renewal",
      "forecasting from stale data",
    ],
    disqualifiers: [
      "pure B2C",
      "fewer than 20 employees",
      "no dedicated sales team",
      "agencies and consultancies",
    ],
    watchTerms: [
      "revenue operations tooling",
      "CRM data hygiene",
      "sales forecasting accuracy",
      "product usage data sales",
    ],
  },
});

const boards: Parameters<typeof addWatchlistEntry>[0][] = [
  { provider: "greenhouse", handle: "gitlab", label: "GitLab", domain: "gitlab.com" },
  { provider: "greenhouse", handle: "figma", label: "Figma", domain: "figma.com" },
  { provider: "lever", handle: "leverdemo", label: "Lever Demo Co", domain: "lever.co" },
  { provider: "ashby", handle: "ramp", label: "Ramp", domain: "ramp.com" },
];
for (const b of boards) await addWatchlistEntry(b);

console.log("Seeded profile:", (await getProfile())?.companyName);
console.log("Watchlist entries:", (await listWatchlist()).length);
